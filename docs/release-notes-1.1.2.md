# RFrontDesk 1.1.2

- Staff Home, checkout and check-in now use the five-minute idle lock. Activity refreshes the timer, and repeating the login shortcut cannot bypass the lock through Cancel.
- Saving and deleting records waits for the database transaction to commit. A rolled-back request reports failure.
- Checkout Undo updates the current item and borrower after merges, keeping counters and recent activity consistent.
- People lists avoid duplicate sorting and reuse numeric name comparison.

All 14 local suites passed, including security, rollback, Undo, responsive layouts and backup tests on synthetic records. Windows downloads are signed by Cameron Ashley. Use the MSIX for installation or extract the portable ZIP before running it.
