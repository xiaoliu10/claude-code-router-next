const errors = {
  invalid_config: [400, 'Invalid ACP transport configuration'],
  invalid_request: [400, 'Invalid ACP request'],
  input_limit: [413, 'ACP prompt exceeds the input limit'],
  auth_required: [401, 'ACP authentication is required'],
  unsupported_version: [502, 'Antigravity CLI 1.5.1 or later is required'],
  unsupported_option: [400, 'Requested ACP session option is unavailable'],
  busy: [503, 'ACP worker pool is full'],
  closed: [503, 'ACP transport is closed'],
  cancelled: [499, 'ACP request was cancelled'],
  timeout: [504, 'ACP request timed out'],
  worker_failed: [502, 'ACP worker failed'],
  protocol_error: [502, 'Invalid ACP response'],
  output_limit: [502, 'ACP output exceeds the limit'],
};

export class AcpError extends Error {
  constructor(code) {
    const [statusCode, message] = errors[code];
    super(message);
    this.code = `acp_${code}`;
    this.statusCode = statusCode;
  }
}
