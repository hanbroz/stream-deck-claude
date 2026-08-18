# Signing in again after the login expires

Date: 2026-08-18

## Goal

When an account's login expires, the conversation stops at an auth wall and
cannot recover on its own: every message runs as `claude --print`, which carries
no TTY, so the sign-in flow cannot run inside the conversation.

The app used to handle this in its own terminal panel — open the split, type
`claude auth login` into it, and let the user finish there. That never worked.
The panel's pty resolves when the shell process is *spawned*, not when it starts
reading stdin, and the command was written immediately afterwards, so the line
was swallowed by a shell that was not listening yet. Worse, the auto-typing only
ran when the terminal was *not* already open — precisely the case where the
shell is least ready — so the path that was supposed to help failed every time.

Run the sign-in in a separate terminal window instead, with the command passed as
an argument rather than typed after the fact.

## Acceptance criteria

1. An expired login opens a new terminal window (`wt.exe`) at the project root
   and runs `claude auth login` in it.
2. The command travels as argv, never as keystrokes written to a shell after it
   opens. Nothing in this path depends on the shell being ready.
3. The window stays open after the command finishes (`-NoExit`), so the sign-in
   result stays readable.
4. The renderer never sends the command string. It asks the main process to sign
   in; the command is a constant on the main side. This handler spawns a shell,
   so accepting a renderer-supplied string would be a command-injection channel.
5. The command is defined once (`CLAUDE_RELOGIN_COMMAND`) and shared by the main
   process that runs it and the notice the user reads, so the two cannot drift
   into telling the user one thing and doing another.
6. The transcript gets a notice turn naming the command that was run and asking
   for the message to be sent again, plus a toast. Nothing reports back when the
   sign-in finishes, so the user has to resend deliberately.
7. Concurrent login events open exactly one window (`reloginPending`).
8. The in-app terminal is left alone. It is a project shell the user may be
   using for something else.

## Notes

`claude login` does not exist. Authentication lives under the `auth` subcommand
(`claude auth login|logout|status`), which is what the shared constant holds.

Windows Terminal is already an install prerequisite for the Companion
(`packaging/nsis/wt-prerequisite.nsh`), and the existing "open folder in
terminal" action already shells out to `wt.exe`, so this adds no new dependency.
