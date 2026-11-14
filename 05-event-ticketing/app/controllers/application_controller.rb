class ApplicationController < ActionController::Base
  include Authentication
  include ErrorHandling

  private
    def authorize!(allowed)
      raise DomainError.new(:forbidden) unless allowed
    end
end
