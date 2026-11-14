from fastapi import FastAPI

from app.api.router import api_router
from app.core.clock import Clock, SystemClock
from app.core.config import Settings, get_settings
from app.core.db import build_engine, build_session_factory
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.core.request_context import RequestContextMiddleware
from app.services.storage import LocalDiskStorage, ReceiptStorage


def create_app(
    settings: Settings | None = None,
    clock: Clock | None = None,
    storage: ReceiptStorage | None = None,
) -> FastAPI:
    """Application factory; run with `uvicorn app.main:create_app --factory`."""
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(title="Expense Tracker", docs_url="/api/docs", openapi_url="/api/openapi.json")
    engine = build_engine(settings.database_url)
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = build_session_factory(engine)
    app.state.clock = clock or SystemClock()
    app.state.storage = storage or LocalDiskStorage(settings.receipt_storage_dir)

    install_error_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    app.include_router(api_router)
    return app
