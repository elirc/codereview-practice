require "json"
require "logger"
require "time"

# Formats every log line as one JSON object. Hash messages are merged into the
# entry so callers can log structured events; the current request id (set by
# RequestLogContext) is attached when present.
class JsonLogFormatter < ::Logger::Formatter
  def call(severity, time, progname, message)
    entry = { time: time.utc.iso8601(3), level: severity }
    request_id = ActiveSupport::IsolatedExecutionState[:request_id]
    entry[:request_id] = request_id if request_id
    entry[:progname] = progname if progname

    case message
    when Hash
      entry.merge!(message)
    when Exception
      entry[:message] = message.message
      entry[:error] = message.class.name
      entry[:backtrace] = message.backtrace&.first(20)
    else
      entry[:message] = message.to_s.strip
    end

    "#{JSON.generate(entry)}\n"
  end
end
