package factory

import "fmt"

type validationError struct{ message string }

func (e *validationError) Error() string       { return e.message }
func invalid(format string, args ...any) error { return &validationError{fmt.Sprintf(format, args...)} }
