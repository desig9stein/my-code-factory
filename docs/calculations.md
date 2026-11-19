# Usage and footprint scenarios — scenario-v1

## Token source

The current adapter reads linked Claude Code JSONL transcripts. It deduplicates lines by message ID inside each file. Main-session messages count only when tool-call content names the task ID; matching subagent transcripts count their usage within the task's creation-to-archive window. Other conversation is omitted. A per-session value is that session's contribution to the selected task, not total session usage across all work.

`fresh = input + cacheWrite + output`; `total = fresh + cacheRead`.

Missing/unreadable transcripts are labelled unavailable or partial. Counts are cached for up to 60 seconds. They are not API billing reconciliation. Unsupported providers do not get fabricated usage. Task attribution may overlap when a call names multiple tasks, so do not treat a sum across tasks as unique workspace consumption.

## Electricity

For each category:

`Wh = tokens × assumed Wh per million tokens / 1,000,000`

Sum the category contributions. Defaults: input 50; cache write 50; cache read 5; output 600 Wh per million tokens. These are uncalibrated demonstration assumptions, not published coefficients for a particular provider/model. Actual consumption depends on hardware, model, batching, context, utilization, and datacenter overhead. No validated uncertainty interval is available.

Appliance runtime: `hours = Wh / watts`. Example constant draws are a 10 W LED bulb, a 60 W laptop, and a 40 W fan. They are not measurements of your devices.

## Carbon

`g CO₂e = Wh / 1,000 × assumed g CO₂e/kWh`

Default grid intensity is 400 g CO₂e/kWh, an arbitrary scenario input rather than a known provider location or power contract.

The car comparison uses the [EPA greenhouse gas equivalencies reference](https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references): 393 g CO₂e/mile for an average gasoline passenger vehicle, based on 2022 fleet data; checked 19 November 2026. Convert with 1.609344 km/mile, then divide scenario emissions by the resulting grams/km. This source supports the vehicle comparison only, not the AI energy assumptions.

## Boundaries

The scenario covers linear serving electricity. No separate cooling/idle correction is added: inclusion depends on the rate supplied. Excluded: model training, hardware manufacture, local builds, user-device electricity, and network energy. The driving equivalent excludes fuel production and vehicle manufacture. This is not a lifecycle footprint or a carbon-offset calculation.

The UI shows active rates, calculation steps, and missing information. Assumptions are stored only in browser local storage. Internal arithmetic uses unrounded values; display rounding and explanatory decimal places do not imply measurement accuracy.
