import { Controller } from "@hotwired/stimulus"

// Shows the time left on a hold and disables checkout once it runs out.
// The server re-checks expiry on every request; this is display only.
export default class extends Controller {
  static targets = ["remaining", "submit"]
  static values = { expiresAt: String }

  connect() {
    this.deadline = Date.parse(this.expiresAtValue)
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  disconnect() {
    clearInterval(this.timer)
  }

  tick() {
    const seconds = Math.max(0, Math.floor((this.deadline - Date.now()) / 1000))

    if (seconds === 0) {
      clearInterval(this.timer)
      this.remainingTarget.textContent = "expired"
      this.submitTargets.forEach((button) => { button.disabled = true })
      return
    }

    const minutes = Math.floor(seconds / 60)
    this.remainingTarget.textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`
  }
}
