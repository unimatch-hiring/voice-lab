# Spec Delta

## Purpose

Lets a visitor list, read and delete the conversations recorded under their own user id —
the contract the history page is written against — and nobody else's.

## ADDED Requirements

### Requirement: Only the owner reaches a conversation
Listing, reading and deleting SHALL be answered for the user id in the request alone. A missing or malformed user id SHALL get 400. A conversation stored under another user id SHALL be answered as if it did not exist (404). No interview key SHALL be needed.

#### Scenario: Owner reads without a key
- **WHEN** a visitor whose interview key has expired lists conversations with their user id
- **THEN** their conversations are returned

#### Scenario: Another user reads a conversation by id
- **WHEN** a request reads a stored conversation with a user id it was not recorded under
- **THEN** the answer is 404 and nothing of it is returned

#### Scenario: Another user's list
- **WHEN** two user ids each have recorded conversations and one of them lists
- **THEN** only that user id's conversations and totals are returned

#### Scenario: Malformed user id
- **WHEN** a request to list conversations carries the user id "not-a-uuid"
- **THEN** the answer is 400

### Requirement: Conversations are listed newest first, a page at a time
The list SHALL return the owner's conversations ordered by start time, newest first, at most 50 per page, each with its id, start time, end time and who ended it (both empty when no ending arrived), the error message if any, time of last entry, and its number of lines and turns. A page SHALL say how to request the next one, or that there is none.

#### Scenario: Two conversations
- **WHEN** the owner lists after one conversation started at 10:00 and another at 11:00
- **THEN** the 11:00 conversation comes first and each entry carries its line and turn counts

#### Scenario: More than one page
- **WHEN** 60 conversations are stored and the owner requests the first page, then the next
- **THEN** the first page holds the 50 newest, the second the remaining 10, and the second says there is no further page

### Requirement: The list carries totals over the whole history
Every page of the list SHALL carry three totals over all the owner's conversations, not only those on the page: all of them, completed (ended by the visitor or the agent) and failed (ended by an error). A conversation with no ending SHALL count in the total only.

#### Scenario: Totals beyond the first page
- **WHEN** the owner has 60 conversations, 55 ended normally and 5 by an error, and requests the first page
- **THEN** the totals are 60, 55 completed and 5 failed

#### Scenario: Conversation without an ending
- **WHEN** one of the owner's conversations never received its ending
- **THEN** it counts in the total and in neither completed nor failed

### Requirement: One conversation is returned whole
Reading one conversation SHALL return its record with every line in the order said — speaker, text, time since start, sequence number — and every turn's metrics in order. A missing id SHALL get 404.

#### Scenario: Read a stored conversation
- **WHEN** the owner reads a conversation with four lines and two turns
- **THEN** the answer holds the four lines in order and the two turns in order, with its start and end

#### Scenario: Lost entries are visible
- **WHEN** a conversation's line with sequence number 3 never arrived but 2 and 4 did
- **THEN** the returned lines carry sequence numbers 2 and 4, so the gap is visible to the reader

### Requirement: The owner can delete a conversation
Deleting a conversation SHALL remove its record, lines and turns, after which it SHALL NOT be listed, counted in the totals or readable. Deleting an id that is not stored under the requesting user id SHALL get 404. Deleting again a conversation the same user already deleted SHALL succeed and change nothing. Nothing else SHALL remove a stored conversation.

#### Scenario: Owner deletes a conversation
- **WHEN** the owner deletes one of three stored conversations
- **THEN** it is absent from the list, the total is 2, and reading it answers 404

#### Scenario: Another user tries to delete
- **WHEN** a request deletes a stored conversation with a user id it was not recorded under
- **THEN** the answer is 404 and the conversation is still stored

#### Scenario: Delete repeated after a lost answer
- **WHEN** the owner deletes a conversation and sends the same delete again
- **THEN** both answers are 204 and the conversation stays deleted

#### Scenario: Old conversations stay
- **WHEN** a conversation was stored long ago and the server has been restarted since
- **THEN** it is still listed and readable by its owner until they delete it

### Requirement: Late entries cannot recreate a deleted conversation
After a conversation is deleted, further entries or openings for its id SHALL NOT bring it back.

#### Scenario: Line arrives after deletion
- **WHEN** the owner deletes a conversation and a delayed retry then delivers another line for it
- **THEN** the delivery is refused and the conversation is still absent from the list

### Requirement: Reads come only from the configured origins
History reads and deletions from a browser origin outside the server's configured origins SHALL be refused with 403.

#### Scenario: Foreign site reads history
- **WHEN** a page on another origin lists conversations from the local server with a valid user id
- **THEN** the answer is 403 and nothing is returned
