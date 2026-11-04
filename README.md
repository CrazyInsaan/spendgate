# SpendGate

A tiny personal expense tracker for UPI payments. You must enter **what the payment is for** before it lets you pay; it then hands off to GPay / PhonePe / Paytm and keeps daily, weekly, monthly and per-category totals. All data stays on your device (export a backup from the Data tab).

## Tests
```
cd tests && npm install && npx playwright install webkit chromium
python3 -m http.server 8765 --directory ..   # in another terminal
npm test
```
