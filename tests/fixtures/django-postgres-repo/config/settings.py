"""Minimal fixture settings — just enough for detectors to see a Django project."""
import os

DEBUG = True
ALLOWED_HOSTS = ['*']
INSTALLED_APPS = ['django.contrib.contenttypes', 'django.contrib.auth']
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': os.environ.get('POSTGRES_DB', 'app'),
        'HOST': os.environ.get('POSTGRES_HOST', 'localhost'),
    }
}
