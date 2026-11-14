package catalog

// Content ratings accepted for Book.ContentRating, from least to most restricted.
var ContentRatings = []string{"everyone", "teen", "mature", "adult"}

// MaxAgeRating bounds Book.AgeRating, the minimum reader age in years.
const MaxAgeRating = 21

// ProviderRating is a metadata provider's community rating normalized to a 0–5 scale.
type ProviderRating struct {
	Provider string   `json:"provider"`
	Rating   *float64 `json:"rating"`
	Count    *int64   `json:"count"`
}
