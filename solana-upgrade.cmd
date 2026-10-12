@echo off
rem Upgrade the Elpida Solana devnet program to contracts/solana/build and turn on SOL/USD launch pricing.
rem Needs devnet SOL in local-data\solana-deployer.json (the program upgrade authority).
cd /d "%~dp0"
call npm run solana:deploy -- --upgrade
echo.
echo If it finished, commit and push deployments\solana-devnet.json so the hosted site uses it.
pause
