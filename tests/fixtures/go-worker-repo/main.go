// A background queue consumer. It dials Redis and processes tasks; it never listens.
package main

import (
	"log"

	"github.com/hibiken/asynq"
)

func main() {
	srv := asynq.NewServer(
		asynq.RedisClientOpt{Addr: "redis:6379"},
		asynq.Config{Concurrency: 10},
	)
	if err := srv.Run(asynq.NewServeMux()); err != nil {
		log.Fatal(err)
	}
}
