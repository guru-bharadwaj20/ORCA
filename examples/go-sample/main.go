// A minimal net/http server — the smallest thing ORCA's Go recipe needs to detect,
// build (`go build`), and run in a distroless runtime image. No external modules, so
// `go mod download` is a no-op and the build is hermetic.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, `{"status":"ok","service":"orca-go-sample"}`)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	addr := ":" + port
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
