<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited -->

# Demo script

Page: `https://concordance.polycode.co.uk`. Sign in as `demo`. The demo takes 12 to 15 minutes.
Steps marked **model** call Bedrock and cost money; steps marked **no model** read the store only.

## The three lines

Say these first, word for word:

> Evidence is never altered, every claim links to a locator, and every automated judgment is reversible by a person.

Each step below names the line it shows.

## Before the demo

1. Open the page and sign in.
2. Ask the warm-up question of step 2 once, five minutes before the demo. The first query resumes the paused database and takes longer.
3. Select **Grenfell Tower Inquiry** in the Inquiry list.

## Steps

| #   | Do                                                                                                                                                                   | The viewer sees                                                                                                                                                                                                                                                       | Rule shown                                                                                   | Cost      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------- |
| 1   | Show the page. Point at the inquiry name under the title.                                                                                                            | "Grenfell Tower Inquiry" on screen, the connection state, the spend strip.                                                                                                                                                                                            | The test data is public record about real deaths. The inquiry is named.                      | no model  |
| 2   | Type: `What did Edward Daffarn hear and see when he got out of bed and opened his front door on floor 16?` Send.                                                     | Four stages tick (rewriting, retrieving, answering, checking). The answer streams. Every sentence ends in a citation chip. A line reads "N of M sentences supported".                                                                                                 | Every claim links to a locator. The model cites evidence ids; the server resolves them.      | **model** |
| 3   | Click the first citation chip.                                                                                                                                       | The PDF viewer opens at the cited page with the cited text marked. The title, page number and a link to the original show.                                                                                                                                            | Evidence is never altered: the viewer shows the stored original, byte for byte.              | no model  |
| 4   | Close the viewer. Point at the Evidence panel and at Referenced documents.                                                                                           | The evidence blocks of this turn, with the cited ones marked, and the documents the answer cites.                                                                                                                                                                     | Every claim links to a locator. The answer rests on listed blocks only.                      | no model  |
| 5   | Click New conversation. Type: `What did Behailu Kebede tell the fire brigade operator in his 999 call, and where did he say the fire was?` Send.                     | A second answer with chips. Click a chip from a different statement and show the page.                                                                                                                                                                                | Every claim links to a locator.                                                              | **model** |
| 6   | Click New conversation. Type: `What is the capital of France?` Send.                                                                                                 | The answer says "the corpus does not say" and cites nothing.                                                                                                                                                                                                          | The answer comes only from the evidence. No prior knowledge enters.                          | **model** |
| 7   | Open the Contradictions panel. Pick the first entry in the Event list. Click a matrix cell.                                                                          | A matrix of witnesses on both axes. The cell shows its label and the two source sentences with the matching spans marked, each with a link to its source.                                                                                                             | Every claim links to a locator. The labels are automated and carry their evidence.           | no model  |
| 8   | In the open cell, open **Override the label**. Choose another label, give a reason, click **Save the label**. Then open **Promote to an accepted fact** and read it. | The cell shows the new label and the reason. The promote form asks for a source citation.                                                                                                                                                                             | Every automated judgment is reversible by a person. A witness assertion is never a fact.     | no model  |
| 9   | In the Generated reports panel, click the report suggestion: `Write me a report on how residents first became aware of the fire`. Wait for version 1.                | The entry `first-awareness.md` with one version. Open it: section headings, a chip in each paragraph, a checks line. Click a chip and show the page.                                                                                                                  | Every claim links to a locator. A paragraph has a chip or the abstention.                    | **model** |
| 10  | Type in the question box: `Add a short section on the 999 calls to first-awareness.md`. Wait for version 2.                                                          | Version 2 beside version 1. Open both.                                                                                                                                                                                                                                | Every automated judgment is reversible by a person: the earlier version stays.               | **model** |
| 11  | Open the Inquiry list and choose **Undercover Policing Inquiry**. Click the first suggestion.                                                                        | The inquiry name changes. The answer cites UCPI documents only. The documents list holds no Grenfell document. Where two documents together could reveal a protected witness, the contradictions panel refuses to show them side by side and each source opens alone. | Evidence is never altered. Protected witnesses have no real identity anywhere in the system. | **model** |
| 12  | Click **Spend by inquiry**.                                                                                                                                          | The month-to-date spend against the cap, and an estimate of model spend by inquiry and day.                                                                                                                                                                           | The cost of each automated step is visible.                                                  | no model  |

Steps 2, 5, 6, 9, 10 and 11 call a model. Step 9 calls it most: a report is a drafting, a writing and a review pass.

## Rules for the presenter

- Read an answer aloud as the page shows it. Do not say what a witness meant.
- When a sentence is flagged unsupported, say that the checking layer flagged it.
- When a step misses, move to the next step and say what the page showed.

## Fallback

The screen recording of this script (the operator's dry run, recorded on the deployed page) replaces any live step that fails. Play it from the step that failed.
