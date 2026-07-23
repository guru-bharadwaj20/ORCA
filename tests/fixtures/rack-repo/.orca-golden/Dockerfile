# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe ruby-bundler (ruby).
FROM ruby:3.3
WORKDIR /app
COPY Gemfile ./
RUN bundle install
COPY . .
EXPOSE 9292
CMD bundle exec rackup --host 0.0.0.0 --port 9292
