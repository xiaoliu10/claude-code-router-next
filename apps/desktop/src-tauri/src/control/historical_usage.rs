use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;

#[derive(PartialEq)]
pub(super) struct Counters([u64; 5]);

impl Counters {
    pub(super) fn from_summary(summary: &Value) -> Option<Self> {
        Some(Self([
            summary["successCount"].as_u64()?,
            summary["totalInputTokens"].as_u64()?,
            summary["totalCacheReadInputTokens"].as_u64()?,
            summary["totalCacheCreationInputTokens"].as_u64()?,
            summary["totalOutputTokens"].as_u64()?,
        ]))
    }
}

pub(super) fn local_input(window: Option<(String, String)>, expected: Counters) -> Option<u64> {
    matched_input(&local_db()?, window, expected)
}

fn local_db() -> Option<Connection> {
    let config = crate::settings::config_path(&|key| std::env::var(key).ok()).ok()?;
    let db = Connection::open_with_flags(
        config.parent()?.join("data/usage.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    db.busy_timeout(std::time::Duration::from_millis(100))
        .ok()?;
    Some(db)
}

// Trust the local database only when all five successful-request counters match
// the authenticated gateway response for exactly the same time bounds.
fn matched_input(
    db: &Connection,
    window: Option<(String, String)>,
    expected: Counters,
) -> Option<u64> {
    let mut sql = format!("SELECT COUNT(*),SUM(input_tokens),SUM(cache_read_input_tokens),SUM(cache_creation_input_tokens),SUM(output_tokens), SUM({ROW_INPUT}), COUNT(CASE WHEN {INVALID_ROW} THEN 1 END) FROM usage_records WHERE status='success'");
    let params: Vec<String> = match window {
        Some((start, end)) => {
            sql.push_str(" AND timestamp >= ?1 AND timestamp <= ?2");
            vec![start, end]
        }
        None => vec![],
    };
    let (actual, input, invalid) = db
        .query_row(&sql, rusqlite::params_from_iter(params), |row| {
            let count = |index: usize| -> rusqlite::Result<u64> {
                let value: i64 = row.get(index)?;
                u64::try_from(value)
                    .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
            };
            Ok((
                Counters([count(0)?, count(1)?, count(2)?, count(3)?, count(4)?]),
                count(5)?,
                count(6)?,
            ))
        })
        .ok()?;
    (actual == expected && invalid == 0).then_some(input)
}

const ROW_INPUT: &str = "COALESCE(effective_input_tokens,input_tokens+cache_read_input_tokens+cache_creation_input_tokens)";
const INVALID_ROW: &str = "input_tokens < 0 OR cache_read_input_tokens < 0 OR cache_creation_input_tokens < 0 OR output_tokens < 0
    OR (effective_input_tokens IS NULL AND cache_read_input_tokens = 0 AND cache_creation_input_tokens = 0)
    OR effective_input_tokens < cache_read_input_tokens";

type DayCounters = HashMap<String, [u64; 5]>;

pub(super) fn unknown_days(summary: &Value) -> DayCounters {
    summary["byDay"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(day, bucket)| {
            if bucket.get("effectiveInputTokens") != Some(&Value::Null) {
                return None;
            }
            Some((
                day.clone(),
                [
                    bucket["count"].as_u64()?,
                    bucket["inputTokens"].as_u64()?,
                    bucket["cacheReadInputTokens"].as_u64()?,
                    bucket["cacheCreationInputTokens"].as_u64()?,
                    bucket["outputTokens"].as_u64()?,
                ],
            ))
        })
        .collect()
}

pub(super) fn local_daily_inputs(
    start: String,
    end: String,
    expected: DayCounters,
) -> Option<HashMap<String, u64>> {
    daily_inputs(&local_db()?, &start, &end, &expected).ok()
}

fn daily_inputs(
    db: &Connection,
    start: &str,
    end: &str,
    expected: &DayCounters,
) -> rusqlite::Result<HashMap<String, u64>> {
    // Gateway byDay counts all requests but sums token fields only for successes.
    let sql = format!(
        "SELECT date(timestamp,'localtime') AS day,COUNT(*),
        SUM(CASE WHEN status='success' THEN input_tokens ELSE 0 END),
        SUM(CASE WHEN status='success' THEN cache_read_input_tokens ELSE 0 END),
        SUM(CASE WHEN status='success' THEN cache_creation_input_tokens ELSE 0 END),
        SUM(CASE WHEN status='success' THEN output_tokens ELSE 0 END),
        SUM(CASE WHEN status='success' THEN {ROW_INPUT} ELSE 0 END),
        COUNT(CASE WHEN status='success' AND ({INVALID_ROW}) THEN 1 END)
        FROM usage_records WHERE timestamp >= ?1 AND timestamp <= ?2 GROUP BY day"
    );
    let mut stmt = db.prepare(&sql)?;
    let mut rows = stmt.query([start, end])?;
    let mut matched = HashMap::new();
    while let Some(row) = rows.next()? {
        let Some(day) = row.get::<_, Option<String>>(0)? else {
            continue;
        };
        let Some(counters) = expected.get(&day) else {
            continue;
        };
        if row.get::<_, i64>(7)? != 0 {
            continue;
        }
        if counters.iter().enumerate().all(|(i, &n)| {
            row.get::<_, i64>(i + 1)
                .ok()
                .and_then(|v| u64::try_from(v).ok())
                == Some(n)
        }) {
            if let Some(input) = row
                .get::<_, i64>(6)
                .ok()
                .and_then(|v| u64::try_from(v).ok())
            {
                matched.insert(day, input);
            }
        }
    }
    Ok(matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daily_recovery_respects_bounds_failed_requests_and_unknown_siblings() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE usage_records(timestamp TEXT,status TEXT,input_tokens INTEGER,cache_read_input_tokens INTEGER,cache_creation_input_tokens INTEGER,output_tokens INTEGER,effective_input_tokens INTEGER);
          INSERT INTO usage_records VALUES ('2026-11-22T12:00:00Z','success',999,100,0,1,NULL),
            ('2026-11-23T12:00:30Z','success',110,100,8,2,110),('2026-11-23T12:00:30Z','success',3,60,7,5,NULL),
            ('2026-11-23T12:00:30Z','error',500,300,40,20,NULL),('2026-11-24T12:00:30Z','success',1000,0,0,0,NULL),
            ('2026-11-23Tbad','success',2,2,0,0,NULL),('2026-11-23T12:00:31Z','success',1,1,0,0,NULL),
            ('2026-11-23T12:00:29Z','success',1,1,0,0,NULL);").unwrap();
        let day = |timestamp: &str| {
            db.query_row("SELECT date(?1,'localtime')", [timestamp], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
        };
        let valid_day = day("2026-11-23T12:00:30Z");
        let invalid_day = day("2026-11-24T12:00:30Z");
        let mut expected = HashMap::from([
            (valid_day.clone(), [5, 115, 162, 15, 7]),
            (invalid_day, [1, 1000, 0, 0, 0]),
        ]);
        let start = "2026-11-23T00:00:00Z";
        let end = "2026-11-25T00:00:00Z";
        assert_eq!(
            daily_inputs(&db, start, end, &expected).unwrap(),
            HashMap::from([(valid_day.clone(), 184)])
        );
        let boundary = "2026-11-23T12:00:30Z";
        let at_boundary = HashMap::from([(valid_day.clone(), [3, 113, 160, 15, 7])]);
        assert_eq!(
            daily_inputs(&db, boundary, boundary, &at_boundary).unwrap(),
            HashMap::from([(valid_day.clone(), 180)])
        );
        expected.get_mut(&valid_day).unwrap()[0] = 2;
        assert!(daily_inputs(&db, start, end, &expected).unwrap().is_empty());
    }

    #[test]
    fn historical_rows_are_estimated_individually_and_only_for_the_matching_window() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE usage_records(timestamp TEXT,status TEXT,input_tokens INTEGER NOT NULL,cache_read_input_tokens INTEGER NOT NULL,cache_creation_input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,effective_input_tokens INTEGER);
            INSERT INTO usage_records VALUES ('01','success',110,100,8,2,110),('02','success',3,60,7,5,NULL),('03','error',90,0,0,0,NULL),('04','success',800,0,0,0,800);").unwrap();
        let window = Some(("01".to_owned(), "03".to_owned()));
        assert_eq!(
            matched_input(&db, window.clone(), Counters([2, 113, 160, 15, 7])),
            Some(180)
        );
        assert_eq!(
            matched_input(&db, window, Counters([2, 114, 160, 15, 7])),
            None
        );
        assert_eq!(
            matched_input(&db, None, Counters([3, 913, 160, 15, 7])),
            Some(980)
        );
        db.execute(
            "INSERT INTO usage_records VALUES ('05','success',1000,0,0,0,NULL)",
            [],
        )
        .unwrap();
        assert_eq!(
            matched_input(&db, None, Counters([4, 1913, 160, 15, 7])),
            None
        );
    }
}
