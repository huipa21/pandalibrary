package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

type problem struct {
	Type   string `json:"type"`
	Title  string `json:"title"`
	Status int    `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// WriteProblem writes a public RFC 9457 problem response.
func WriteProblem(w http.ResponseWriter, logger *slog.Logger, status int, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(problem{
		Type: "about:blank", Title: http.StatusText(status), Status: status, Detail: detail,
	}); err != nil {
		logger.Error("write problem response", "error", err)
	}
}
