# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe php-laravel (php).
FROM composer:2 AS builder
WORKDIR /app
COPY composer.json ./
COPY . .
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader
FROM php:8.3-cli
WORKDIR /app
COPY --from=builder /app /app
EXPOSE 8000
CMD php artisan serve --host=0.0.0.0 --port=8000
