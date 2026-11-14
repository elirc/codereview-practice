from fastapi import APIRouter, Depends

from app.api import auth, health, rates, reports, users
from app.api.deps import require_csrf_header

api_router = APIRouter(prefix="/api", dependencies=[Depends(require_csrf_header)])
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(rates.router)
api_router.include_router(reports.router)
