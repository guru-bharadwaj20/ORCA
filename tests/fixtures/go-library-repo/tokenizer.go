// Package tokenizer splits text into tokens. It is consumed by other modules and has
// no entrypoint of its own: no main, no cmd/, no server.
package tokenizer

import "strings"

func Split(text string) []string { return strings.Fields(text) }
