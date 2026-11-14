from enum import StrEnum


class Role(StrEnum):
    EMPLOYEE = "employee"
    MANAGER = "manager"
    FINANCE = "finance"
    ADMIN = "admin"


class ReportStatus(StrEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    REIMBURSED = "reimbursed"


class StepKind(StrEnum):
    MANAGER = "manager"
    FINANCE = "finance"


class StepStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SKIPPED = "skipped"


class ExpenseCategory(StrEnum):
    TRAVEL = "travel"
    MEALS = "meals"
    LODGING = "lodging"
    SUPPLIES = "supplies"
    OTHER = "other"
