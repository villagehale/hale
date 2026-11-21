---
name: browser-use-cart-read
whenToUse: Appended to a registration run whose cart Hale compares with what the parent approved. It asks the run to copy the cart's own line off the page.
task: plan
tools: []
---

## Also report `cart_read`

Hale compares the cart with what the parent approved, so copy these off the cart or checkout page as they appear. Copy; do not work anything out, and do not fill a field from the facts above. When the page does not show one, it is null.

- `provider_course_id`: the course number or code the cart line shows.
- `session_label`: the program's name as the cart line shows it.
- `session_date`: the date of the first class on the cart line, as `YYYY-MM-DD`.
- `session_time`: its start time, as 24-hour `HH:MM`.
- `participant_first_name`: the first name of the participant the cart line is for.
- `line_count`: how many registration lines the cart holds.
- `quantity`: the quantity on this line.

Return `cart_read` as null only when you never reached a cart.
