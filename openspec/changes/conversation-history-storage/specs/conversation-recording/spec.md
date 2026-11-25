# Spec Delta

## Purpose

Keeps every ElevenLabs conversation in SQLite as it happens — its lines, its turn metrics and
how it ended — under the user id of the browser that held it, so that its owner can come back
to it, and tells the visitor whether it was saved.

## ADDED Requirements

### Requirement: Each browser has its own user id
On first visit the page SHALL generate a random UUID version 4 as the visitor's user id and SHALL keep it across reloads in that browser. Every history request SHALL carry it.

#### Scenario: First visit
- **WHEN** the page opens in a browser that has no user id yet
- **THEN** a UUID v4 is generated and kept, and the next history request carries it

#### Scenario: Reload keeps the id
- **WHEN** the page is reloaded after a conversation was recorded
- **THEN** the same user id is used as before the reload

### Requirement: The server accepts only a well-formed user id
Every history request SHALL be refused with 400 when its user id is missing or is not a UUID version 4, and nothing SHALL be stored or returned for it.

#### Scenario: Missing user id
- **WHEN** a request to open a conversation carries no user id
- **THEN** the answer is 400 and nothing is stored

#### Scenario: Not a version 4 UUID
- **WHEN** a request carries the user id "123" or a UUID of another version
- **THEN** the answer is 400

### Requirement: History is recorded only where a history server is configured
The page SHALL send history only when it has a history server address: by default in a development build, or when one is set at build time. Without one it SHALL send nothing and show no saved line.

#### Scenario: Published site
- **WHEN** a conversation runs on a production build with no history server address set
- **THEN** no history request is sent and the page looks as it did before this change

#### Scenario: Local development
- **WHEN** a conversation runs on the development server with no address set
- **THEN** history is sent to the local history server

### Requirement: A conversation is stored from the moment it connects
When an ElevenLabs conversation connects, the system SHALL store a conversation record under the visitor's user id, carrying the provider's conversation id, the agent id and the server's start time, before any line of it is stored.

#### Scenario: Connected conversation appears before anyone speaks
- **WHEN** a visitor starts a conversation and the session connects
- **THEN** a stored conversation exists under the visitor's user id with that conversation id, the agent id and a start time, and no lines

#### Scenario: Opening the same conversation twice keeps one record
- **WHEN** the opening of a conversation is delivered a second time by the same user id
- **THEN** there is still exactly one stored conversation with that id and its start time is unchanged

### Requirement: Attempts that never connect are not recorded
A start that fails before the session connects SHALL leave no stored conversation and SHALL NOT show a saved or not-saved line.

#### Scenario: Microphone blocked
- **WHEN** the visitor presses start and the microphone is blocked
- **THEN** no history request is sent and only the existing start error is shown

#### Scenario: Key rejected
- **WHEN** the token minter rejects the key while the conversation starts
- **THEN** no history request is sent and no conversation is stored

### Requirement: Lines are stored as they are said
The system SHALL store each transcript line — the visitor's recognised speech and each complete agent reply — while the conversation is still running, in the order they occurred, with the speaker and the time since the conversation started. Blank lines SHALL NOT be stored.

#### Scenario: A user line is stored before the conversation ends
- **WHEN** the visitor's speech is recognised as "Hello there" during a running conversation
- **THEN** the stored conversation holds a user line "Hello there" while the conversation is still running

#### Scenario: Agent reply follows the user line
- **WHEN** the visitor says one line and the agent answers with one complete reply
- **THEN** the stored lines are the user line followed by the agent line, each with its time since the start

#### Scenario: Blank recognition is not stored
- **WHEN** the recognised speech is only whitespace
- **THEN** no line is stored for it

### Requirement: Turn metrics are stored when a turn completes
The system SHALL store the metrics of every completed turn — milliseconds per stage, the turn's total, model tokens and synthesised characters — as soon as the turn completes.

#### Scenario: Completed turn is stored
- **WHEN** a turn completes with stage durations, a total of 2400 ms, 12 tokens and 80 characters
- **THEN** the stored conversation holds one turn with exactly those values

### Requirement: The ending is stored with who ended it
The system SHALL store when a conversation ended and whether the visitor, the agent or an error ended it, and the error's message when there was one. Only the first ending SHALL count.

#### Scenario: Visitor stops the conversation
- **WHEN** the visitor presses stop
- **THEN** the stored conversation has an end time and is marked as ended by the visitor, exactly once

#### Scenario: Connection fails
- **WHEN** the conversation drops with an error message
- **THEN** the stored conversation is marked as ended by an error and keeps that message

### Requirement: Delivery is retried and never duplicates
An entry that fails to reach the server because of the network, a 5xx or no answer SHALL be sent again, in order, until it is stored or refused — while the conversation runs, and for 15 seconds after it ends. The ending SHALL be sent as soon as the conversation ends, without waiting out an earlier retry delay. Receiving the same entry more than once SHALL store it once.

#### Scenario: Server briefly unavailable
- **WHEN** the server is unreachable for two deliveries and then accepts
- **THEN** every line is stored once, in the order it was said

#### Scenario: Server comes back just before the end
- **WHEN** every delivery fails for the first 40 seconds of a conversation, the server then becomes reachable, and the conversation ends a moment later
- **THEN** every line and the ending are stored within the 15 seconds after the end, and the page says the conversation was saved

#### Scenario: Server accepts the request but never answers
- **WHEN** a delivery gets no answer
- **THEN** it is sent again, and the lines are stored once the server answers

#### Scenario: Same entry delivered twice
- **WHEN** an entry already stored is delivered again
- **THEN** the stored conversation holds it once and the delivery is acknowledged as successful

### Requirement: An over-long line is clipped, not lost
A line longer than 4000 characters SHALL be stored clipped to its first 4000 characters, and an error message longer than 500 characters SHALL be stored clipped to its first 500. Recording SHALL continue after either.

#### Scenario: Very long agent reply
- **WHEN** the agent gives a 4500-character reply and the conversation then continues and ends normally
- **THEN** the stored reply is its first 4000 characters, the later lines and the ending are stored, and the page says the conversation was saved

#### Scenario: Very long error message
- **WHEN** the conversation drops with a 600-character error message
- **THEN** the stored conversation is marked as ended by an error and keeps the first 500 characters of the message

### Requirement: Recording never interrupts the conversation
A failure to store history SHALL NOT stop, delay or alter the conversation itself.

#### Scenario: History server down for the whole conversation
- **WHEN** every history delivery fails during a conversation
- **THEN** the conversation runs and ends exactly as it would without history

### Requirement: The visitor is told whether the conversation was saved
After a recorded conversation ends, the page SHALL say it was saved, with its length and outcome, once every entry is acknowledged. It SHALL show an error instead when the server refuses the recording, or when entries are still unsaved 15 seconds after the end; after that error nothing more of that conversation is sent. A refusal during the conversation SHALL show the error at once. Starting a new conversation SHALL NOT stop the delivery of the previous one or hide whether it was saved.

#### Scenario: Everything saved
- **WHEN** a conversation of 6 minutes 48 seconds ends normally and every entry is acknowledged
- **THEN** the page says it was saved to history, 6:48, completed

#### Scenario: Server not running
- **WHEN** a conversation ends and its entries are still unacknowledged 15 seconds later
- **THEN** the page shows an error saying the conversation was not saved to history

#### Scenario: New conversation while the last one is still saving
- **WHEN** a conversation ends while the server is briefly unreachable, and the visitor starts a new one before its entries are acknowledged
- **THEN** the earlier conversation's remaining lines and ending are still delivered, and the page says whether the earlier conversation was saved, separately from the new one

#### Scenario: Recording refused mid-conversation
- **WHEN** the server answers a delivery with a 4xx status while the conversation runs
- **THEN** the page shows the not-saved error at once, stops sending history, and the conversation continues

### Requirement: Only ElevenLabs conversations are recorded
A conversation held on the backup engine SHALL send no history and show no saved line.

#### Scenario: Backup engine sends nothing
- **WHEN** a visitor whose key is set to the backup engine holds a conversation
- **THEN** no history request is sent, no conversation is stored and no saved line is shown

### Requirement: Only the user who opened a conversation adds to it
Adding to a conversation, and opening an id already stored, SHALL require the user id the conversation was opened with; another user id SHALL get 403 and change nothing.

#### Scenario: Another user writes to someone else's conversation
- **WHEN** a request with a different user id adds a line to a stored conversation
- **THEN** the answer is 403 and the conversation is unchanged

#### Scenario: Opening an id that belongs to another user
- **WHEN** a user id opens a conversation whose id is already stored under a different user id
- **THEN** the answer is 403 and the stored conversation is unchanged

### Requirement: Recording requests are bounded
The server SHALL refuse with 400 a line longer than 4000 characters, a delivery of more than 50 entries, and a delivery whose lines would take a conversation past 2000 lines, storing nothing from that delivery. Turns and the ending of a conversation holding 2000 lines SHALL still be accepted. A request body larger than 1 MiB SHALL be refused with 413 before any of it is stored.

#### Scenario: Oversized line
- **WHEN** a line of 4001 characters is delivered
- **THEN** the answer is 400 and nothing from that delivery is stored

#### Scenario: Too many entries in one delivery
- **WHEN** a delivery carries 51 entries
- **THEN** the answer is 400 and none of them is stored

#### Scenario: Conversation full of lines
- **WHEN** a conversation holds 2000 lines and a delivery brings one more line, then another brings its ending
- **THEN** the line is refused with 400 and the ending is stored

#### Scenario: Oversized request body
- **WHEN** a request body of 1 MiB and one byte arrives, from any origin
- **THEN** the answer is 413 and nothing is stored

### Requirement: The server answers only the configured origins
The server SHALL answer browser requests only from its configured origins — by default the local development and preview servers — and refuse any other origin with 403.

#### Scenario: Local page
- **WHEN** the page served by the development server sends history
- **THEN** the server accepts it

#### Scenario: Foreign site
- **WHEN** a page on another origin sends a history request to the local server
- **THEN** the answer is 403 and nothing is stored or returned
