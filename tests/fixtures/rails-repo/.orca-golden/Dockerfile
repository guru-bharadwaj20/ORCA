# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe ruby-rails (ruby).
FROM ruby:3.3
WORKDIR /app
COPY Gemfile ./
RUN bundle install
COPY . .
EXPOSE 3000
CMD bundle exec rails server -b 0.0.0.0 -p 3000
