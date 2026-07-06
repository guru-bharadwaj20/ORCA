"""Minimal Django settings for the ORCA Postgres sample."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-insecure-secret-key")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "core",
]

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# Connection details come from the environment (set by docker-compose).
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "orca"),
        "USER": os.environ.get("POSTGRES_USER", "orca"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", "orca"),
        "HOST": os.environ.get("POSTGRES_HOST", "db"),
        "PORT": os.environ.get("POSTGRES_PORT", "5432"),
    }
}

TEMPLATES = []
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
