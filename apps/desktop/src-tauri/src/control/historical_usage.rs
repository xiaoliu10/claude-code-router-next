use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

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
    let config = crate::settings::config_path(&|key| std::env::var(key).ok()).ok()?;
    let db = Connection::open_with_flags(
        config.parent()?.join("data/usage.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    db.busy_timeout(std::time::Duration::from_millis(100))
        .ok()?;
    matched_input(&db, window, expected)
}

// Trust the local database only when all five successful-request counters match
// the authenticated gateway response for exactly the same time bounds.
fn matched_input(
    db: &Connection,
    window: Option<(String, String)>,
    expected: Counters,
) -> Option<u64> {
    let mut sql = String::from("SELECT COUNT(*),SUM(input_tokens),SUM(cache_read_input_tokens),SUM(cache_creation_input_tokens),SUM(output_tokens),
        SUM(COALESCE(effective_input_tokens,input_tokens+cache_read_input_tokens+cache_creation_input_tokens)),
        COUNT(CASE WHEN input_tokens < 0 OR cache_read_input_tokens < 0 OR cache_creation_input_tokens < 0 OR output_tokens < 0
          OR effective_input_tokens < cache_read_input_tokens THEN 1 END)
        FROM usage_records WHERE status='success'");
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

#[cfg(test)]
mod tests {
    use super::*;
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
    }
}
