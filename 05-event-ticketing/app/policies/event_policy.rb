class EventPolicy < ApplicationPolicy
  PUBLIC_STATUSES = %w[ published cancelled ].freeze

  # Events the user may look at: anything public, plus their own drafts.
  def self.visible_scope(user)
    return Event.all if user&.admin?

    public_events = Event.where(status: PUBLIC_STATUSES)
    return public_events unless user&.organizer?

    public_events.or(Event.where(organizer_id: user.id))
  end

  # Events the user may manage: all for admins, their own for organisers.
  def self.manageable_scope(user)
    return Event.none unless user&.manager?
    return Event.all if user.admin?

    Event.where(organizer_id: user.id)
  end

  def show?
    PUBLIC_STATUSES.include?(record.status) || manage?
  end

  def manage?
    return true if admin?

    signed_in? && user.organizer? && record.organizer_id == user.id
  end
end
