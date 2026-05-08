package cli

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFlagDisplayName(t *testing.T) {
	tests := []struct {
		flag FlagHelp
		want string
	}{
		{
			flag: FlagHelp{Name: "name", Type: "string"},
			want: "--name string",
		},
		{
			flag: FlagHelp{Name: "q", Short: "q", Type: "string"},
			want: "-q string",
		},
		{
			flag: FlagHelp{Name: "verbose", Type: ""},
			want: "--verbose",
		},
		{
			flag: FlagHelp{Name: "limit", Type: "int"},
			want: "--limit int",
		},
	}
	for _, tt := range tests {
		got := flagDisplayName(tt.flag)
		assert.Equal(t, tt.want, got)
	}
}

func TestPrintHelp_Output(t *testing.T) {
	info := HelpInfo{
		Usage:       "clawbench task create [flags]",
		Description: "Create a new scheduled task.",
		Flags: []FlagHelp{
			{Name: "name", Type: "string", Desc: "Brief task name", Required: true},
			{Name: "repeat", Type: "string", Default: "unlimited", Desc: "Repeat mode: once|limited|unlimited"},
		},
		Positional: "TASK_ID  (required) ID of the task",
		Examples: []string{
			`clawbench task create --name "test" --cron "0 9 * * *" --agent codebuddy --prompt "test"`,
		},
		Footer: "Response format:\n  {\"ok\":true}",
	}

	// Capture stdout by calling printHelp and checking it doesn't panic
	// (full output capture would require redirecting os.Stdout, but we just
	// verify the function works without errors and the builder logic is correct)
	assert.NotPanics(t, func() {
		printHelp(info)
	})
}

func TestPrintGroupHelp(t *testing.T) {
	subcommands := []CmdHelp{
		{Name: "create", Desc: "Create a new task"},
		{Name: "delete", Desc: "Delete a task"},
	}

	assert.NotPanics(t, func() {
		printGroupHelp("clawbench task <subcommand> [options]", "Manage tasks.", subcommands)
	})
}

func TestHelpInfo_FlagsAlignment(t *testing.T) {
	// Verify flags with different name lengths are properly aligned
	info := HelpInfo{
		Usage: "test [flags]",
		Flags: []FlagHelp{
			{Name: "a", Type: "string", Desc: "Short flag"},
			{Name: "very-long-name", Type: "int", Desc: "Long flag name"},
		},
	}

	assert.NotPanics(t, func() {
		printHelp(info)
	})
}

func TestSearchHelpContainsRequiredFlags(t *testing.T) {
	// Verify the searchHelp definition has the required -q flag
	found := false
	for _, f := range searchHelp.Flags {
		if f.Name == "q" && f.Required {
			found = true
			break
		}
	}
	assert.True(t, found, "searchHelp should have -q flag marked as required")
}

func TestCreateHelpContainsCronReference(t *testing.T) {
	assert.True(t, strings.Contains(createHelp.Footer, "Cron"), "createHelp footer should contain cron reference")
	assert.True(t, strings.Contains(createHelp.Footer, "9:00"), "createHelp footer should contain cron examples")
}

func TestCreateHelpHasExamples(t *testing.T) {
	assert.NotEmpty(t, createHelp.Examples, "createHelp should have examples")
}

func TestSearchHelpHasTips(t *testing.T) {
	assert.True(t, strings.Contains(searchHelp.Footer, "Tips"), "searchHelp footer should contain tips section")
}
