# Lets forms edit instants as wall-clock values ("2030-06-01T19:00") in the
# record's own time zone. Raw input is kept until validation so that the zone
# can be assigned in any order, and is echoed back when a form re-renders.
module ZonedTimeInput
  extend ActiveSupport::Concern

  LOCAL_FORMAT = "%Y-%m-%dT%H:%M".freeze

  included do
    before_validation :apply_zoned_time_input
    validate :zoned_time_input_parsed
  end

  class_methods do
    def zoned_time_input(*attributes)
      attributes.each do |attribute|
        define_method(:"#{attribute}_local") do
          raw = zoned_time_input_values[attribute]
          next raw unless raw.nil?

          value = public_send(attribute)
          zone = ActiveSupport::TimeZone[input_time_zone.to_s]
          value && zone ? value.in_time_zone(zone).strftime(LOCAL_FORMAT) : nil
        end

        define_method(:"#{attribute}_local=") do |text|
          zoned_time_input_values[attribute] = text.to_s.strip
        end
      end
    end
  end

  private
    def zoned_time_input_values
      @zoned_time_input_values ||= {}
    end

    def zoned_time_input_invalid
      @zoned_time_input_invalid ||= []
    end

    def apply_zoned_time_input
      zone = ActiveSupport::TimeZone[input_time_zone.to_s]
      zoned_time_input_invalid.clear

      zoned_time_input_values.each do |attribute, text|
        if text.empty?
          self[attribute] = nil
        elsif zone
          parsed = parse_in_zone(zone, text)
          if parsed
            self[attribute] = parsed
          else
            zoned_time_input_invalid << attribute
          end
        end
      end
    end

    def parse_in_zone(zone, text)
      zone.parse(text)
    rescue ArgumentError
      nil
    end

    def zoned_time_input_parsed
      zoned_time_input_invalid.each do |attribute|
        errors.add(attribute, "is not a valid date and time")
      end
    end
end
