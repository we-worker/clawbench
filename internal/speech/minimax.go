package speech

import "strconv"

// MiniMaxProvider implements SpeechProvider using the mmx CLI tool.
type MiniMaxProvider struct {
	CLISpeechProvider
	// TTSModel is the model ID for speech synthesis (default: "speech-2.8-hd").
	TTSModel string
	// TTSVoice is the voice ID for speech synthesis (default: "female-chengshu").
	TTSVoice string
	// TTSSpeed is the speech speed multiplier (default: 1.5).
	TTSSpeed float64
	// TTSFormat is the output audio format (default: "mp3").
	TTSFormat string
}

// NewMiniMaxProvider creates a MiniMaxProvider with sensible defaults.
func NewMiniMaxProvider() *MiniMaxProvider {
	p := &MiniMaxProvider{
		TTSModel:  "speech-2.8-hd",
		TTSVoice:  "female-chengshu",
		TTSSpeed:  1.5,
		TTSFormat: "mp3",
	}

	p.CLISpeechProvider = newCLISpeechProvider(SynthesizeOptions{
		BinaryName: "mmx",
		TextSource: TextViaStdin,
		LogName:    "mmx",
		ExtraArgs: func(cliPath string, text string, outputPath string, language string) []string {
			args := []string{
				"speech", "synthesize",
				"--text-file", "-",
				"--format", p.TTSFormat,
				"--out", outputPath,
				"--quiet",
			}
			if p.TTSModel != "" {
				args = append(args, "--model", p.TTSModel)
			}
			if p.TTSVoice != "" {
				args = append(args, "--voice", p.TTSVoice)
			}
			if language != "" {
				args = append(args, "--language", language)
			}
			if p.TTSSpeed > 0 {
				args = append(args, "--speed", strconv.FormatFloat(p.TTSSpeed, 'f', -1, 64))
			}
			return args
		},
	})

	return p
}
