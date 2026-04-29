package model

// ForwardedPort represents a registered forwarded port.
type ForwardedPort struct {
	Port       int    `json:"port"`       // Local port number (e.g. 5173)
	Name       string `json:"name"`       // User-friendly name (e.g. "Vite Dev Server")
	AutoDetect bool   `json:"autoDetect"` // Whether this was auto-detected
	Active     bool   `json:"active"`     // Whether the port is currently listening
}

// ProxyConfig holds the proxy section from config.yaml.
type ProxyConfig struct {
	Enabled      bool   `yaml:"enabled"`       // Enable/disable port forwarding (default: true)
	AllowedPorts string `yaml:"allowed_ports"` // Port ranges, e.g. "1024-65535" or "3000,5173,8080" (default: "1024-65535")
}
