@echo off
REM ============================================================
REM  Launches the INSTALLED Interests App (Electron desktop app).
REM
REM  This file used to start a Python static-file server on port
REM  3456 — a relic of the pre-Electron single-file era. That
REM  server SQUATTED the real app's port and blocked its local
REM  service from starting (diagnosed 2026-07-18; see
REM  docs/superpowers/2026-07-17-incident-root-cause.md).
REM ============================================================
start "" "C:\Program Files\Interests App\Interests App.exe"
