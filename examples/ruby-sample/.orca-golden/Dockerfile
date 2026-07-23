# syntax=docker/dockerfile:1
# ORCA synthesized image — recipe ruby-sinatra (ruby).
FROM ruby:3.3
WORKDIR /app
COPY Gemfile ./
RUN bundle install
COPY . .
EXPOSE 4567
CMD bundle exec ruby app.rb -o 0.0.0.0 -p 4567