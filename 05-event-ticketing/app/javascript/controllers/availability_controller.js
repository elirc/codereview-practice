import { Controller } from "@hotwired/stimulus"

// Polls the availability endpoint and updates each tier's label in place.
export default class extends Controller {
  static values = { url: String, interval: { type: Number, default: 15000 } }

  connect() {
    this.timer = setInterval(() => this.refresh(), this.intervalValue)
  }

  disconnect() {
    clearInterval(this.timer)
  }

  async refresh() {
    let response
    try {
      response = await fetch(this.urlValue, { headers: { Accept: "application/json" } })
    } catch {
      return
    }
    if (!response.ok) return

    const { tiers } = await response.json()
    tiers.forEach((tier) => {
      const cell = this.element.querySelector(`[data-availability-tier-id="${tier.id}"]`)
      if (cell) cell.textContent = this.label(tier)
    })
  }

  label(tier) {
    if (!tier.waitlist_open) return `${tier.available} available`
    return tier.available > 0 ? "Waitlist" : "Sold out"
  }
}
