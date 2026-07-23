# A minimal Sinatra app — the smallest repo that exercises ORCA's ruby-sinatra recipe:
# detect the Gemfile + sinatra dependency, `bundle install`, run with `ruby app.rb`.
require "sinatra"
require "json"

set :bind, "0.0.0.0"
set :port, ENV.fetch("PORT", "4567").to_i

get "/" do
  content_type :json
  { status: "ok", service: "orca-ruby-sample" }.to_json
end
