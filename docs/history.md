# Dialogue history

## Components

```mermaid
flowchart TD
    subgraph Browser
        Shell["VoiceLab · page navigation and dialogue ID"]
        App["App · voice session"]
        History["History · list and transcript"]
        Capture["historyCapture"]
        Queue["historyWriteQueue"]
        Pending["historyPendingStorage"]
        Local[("localStorage · pending writes per API address")]
        Client["historyApi · HTTP client"]

        Shell --> App
        Shell --> History
        App -->|Session events and final text| Capture
        Capture -->|Dialogue updates| Queue
        Queue -.->|Save warnings| Shell
        Queue -->|Save, recover, clear| Pending
        Pending --> Local
        Queue -->|Write| Client
        History -->|List, read, delete| Client
    end

    subgraph Server["Standalone history server"]
        API["server/index.js · HTTP routes"]
        Store["historyStore"]
        Files[("Disk · dialogue JSON and deletion markers")]
        API --> Store --> Files
    end
    Client -->|HTTP| API
```

## Save, read and delete a dialogue

Each Start opens a voice session. All sessions started in one page load share a dialogue ID.
A silent first session stays in memory until a later session produces text. The first write
then includes both sessions, so the history summary counts their active time.

```mermaid
sequenceDiagram
    actor User
    participant Voice as Voice page
    participant Queue as History write queue
    participant Local as Browser storage
    participant API as History API
    participant History as History page

    Note over User,Queue: Each Start/Stop cycle on this page uses the same dialogue ID
    User->>Voice: Start conversation
    loop Each final utterance, then the session ending
        Voice->>Queue: Enqueue update for this dialogue and session
        Queue->>Local: Keep a pending copy
        Queue->>API: PUT /dialogues/{id}
        opt Temporary failure or lost acknowledgement
            Queue-->>Voice: Show a save warning while voice continues
            Queue->>API: Retry the same update
        end
        API->>API: Merge by session ID and utterance sequence, then replace JSON
        API-->>Queue: 204 No Content
        Queue->>Local: Remove the acknowledged write
    end

    User->>History: Open History
    History->>API: GET /dialogues
    API-->>History: Start time, active duration and ending for each dialogue
    User->>History: Open transcript
    History->>API: GET /dialogues/{id}
    API-->>History: Sessions and utterances in order
    opt Reader confirms deletion from another page load
        User->>History: Delete, then confirm
        History->>API: DELETE /dialogues/{id}
        API->>API: Write deletion marker and remove transcript JSON
        API-->>History: 204 No Content
        History-->>User: Remove dialogue from the list
    end
```

After a reload, the queue resumes pending writes for the configured API. If the browser
cannot store a pending copy, the queue keeps it in memory and asks the user to keep the
page open. A delayed write for a deleted dialogue receives HTTP 410, and the queue drops
the remaining writes for that dialogue.
