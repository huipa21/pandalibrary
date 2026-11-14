package catalog

import "regexp"

var iconNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)

func validateIcon(icon string) error {
	if icon != "" && (len(icon) > 64 || !iconNamePattern.MatchString(icon)) {
		return invalid("icon must be empty or a lowercase hyphen-separated identifier of at most 64 bytes")
	}
	return nil
}
