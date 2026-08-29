# Wraps the current `prompt` function (whatever $PROFILE defined, or
# PowerShell's own built-in default if nothing did) so eDEX-UI BK can track
# the shell's working directory. Windows has no /proc and no lsof — OSC 7
# is the only cwd source there (see src/main/terminal-metadata.js).
#
# Injected at spawn time via -NoExit -EncodedCommand (see win32ShellArgs in
# src/main/terminal-metadata.js) — never written into $PROFILE, and never
# saved to disk anywhere the user would see it as "their" config. Profiles
# still load normally before this runs, so it wraps whatever `prompt`
# already exists rather than replacing it outright.
if (-not $global:__EdexOsc7PromptInstalled) {
    $global:__EdexOriginalPrompt = $function:prompt
    $global:__EdexOsc7PromptInstalled = $true

    function global:prompt {
        $osc7 = ''
        if ($PWD.Provider.Name -eq 'FileSystem') {
            try {
                $uri = ([System.Uri]$PWD.ProviderPath).AbsoluteUri
                $osc7 = "$([char]27)]7;$uri$([char]7)"
            } catch {
                # A path the Uri class won't parse — skip this tick, the
                # panel just keeps showing its last known cwd.
            }
        }
        $osc7 + (& $global:__EdexOriginalPrompt)
    }
}
