"""Settings for the shop inventory service.

Every value comes from the environment and is validated here once, at start-up.
"""

import re
from pathlib import Path

import environ
import structlog
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env()
if (BASE_DIR / ".env").exists():
    environ.Env.read_env(str(BASE_DIR / ".env"))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ImproperlyConfigured(message)


DEBUG = env.bool("DJANGO_DEBUG", default=False)
SECRET_KEY = env.str("DJANGO_SECRET_KEY")
_require(len(SECRET_KEY) >= 16, "DJANGO_SECRET_KEY must be at least 16 characters")
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

LOG_LEVEL = env.str("LOG_LEVEL", default="INFO").upper()
_require(
    LOG_LEVEL in {"DEBUG", "INFO", "WARNING", "ERROR"},
    "LOG_LEVEL must be one of DEBUG, INFO, WARNING, ERROR",
)

SHOP_CURRENCY = env.str("SHOP_CURRENCY", default="USD")
_require(
    re.fullmatch(r"[A-Z]{3}", SHOP_CURRENCY) is not None,
    "SHOP_CURRENCY must be an upper-case ISO-4217 code such as USD",
)

RESERVATION_MINUTES = env.int("RESERVATION_MINUTES", default=30)
_require(RESERVATION_MINUTES > 0, "RESERVATION_MINUTES must be a positive number of minutes")

CLERK_REFUND_LIMIT_MINOR = env.int("CLERK_REFUND_LIMIT_MINOR", default=5000)
_require(CLERK_REFUND_LIMIT_MINOR >= 0, "CLERK_REFUND_LIMIT_MINOR must not be negative")

PAYMENT_PROVIDER = env.str("PAYMENT_PROVIDER", default="fake")
_require(PAYMENT_PROVIDER in {"fake"}, "PAYMENT_PROVIDER must be 'fake'")
PAYMENT_WEBHOOK_SECRET = env.str("PAYMENT_WEBHOOK_SECRET")
_require(len(PAYMENT_WEBHOOK_SECRET) >= 16, "PAYMENT_WEBHOOK_SECRET must be at least 16 characters")
PAYMENT_WEBHOOK_SECRET_PREVIOUS = env.str("PAYMENT_WEBHOOK_SECRET_PREVIOUS", default="")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework.authtoken",
    "django_structlog",
    "core",
    "catalog",
    "inventory",
    "orders",
    "payments",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django_structlog.middlewares.RequestMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

DATABASES = {"default": env.db("DATABASE_URL")}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_HTTPONLY = True

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["core.permissions.IsStaffMember"],
    "DEFAULT_PAGINATION_CLASS": "core.pagination.Pagination",
    "PAGE_SIZE": 50,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "core.errors.exception_handler",
    "UNAUTHENTICATED_USER": "django.contrib.auth.models.AnonymousUser",
}

CELERY_BROKER_URL = env.str("CELERY_BROKER_URL")
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_IGNORE_RESULT = True
CELERY_WORKER_HIJACK_ROOT_LOGGER = False
CELERY_BEAT_SCHEDULE = {
    "expire-reservations": {"task": "orders.expire_reservations", "schedule": 60.0},
    "requeue-stale-events": {"task": "payments.requeue_stale_events", "schedule": 300.0},
}

DJANGO_STRUCTLOG_CELERY_ENABLED = True

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {
            "()": structlog.stdlib.ProcessorFormatter,
            "processor": structlog.processors.JSONRenderer(),
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "json"},
    },
    "root": {"handlers": ["console"], "level": LOG_LEVEL},
    "loggers": {
        "django.server": {"handlers": ["console"], "level": "WARNING", "propagate": False},
    },
}

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.filter_by_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)
