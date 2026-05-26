- [] telegram
- [] substack
- [] rss
- [] reddit selected subreddits (post summarize only?)
- [] optionally parse comments (telegram, youtube, substack etc)

Flowchart:

1. User registers, he adds sources, gets asked about interests

User Entity:

- id: uiid
- name: string
- email: string
- password: string
- sources: Source[]
- interests: Interest[]

Interest Entity:

- id: uiid
- user_id: string
- type: 'technology' | 'politics' | 'sports' | 'entertainment' | 'other'
- description: string

Source Entity = TelegramEntity | SubstackEntity | RssEntity | RedditEntity

TelegramSource Entity:

- id: uiid
- user_id: string
- channels: TelegramChannel[]
- dialogues: TelegramDialogue[]
- channel_summaries: ChannelSummary[]
- dialogue_summaries: DialogueSummary[]

TelegamChannel Entity:

- id: uiid
- user_id: string
- telegram_entity_id: string
- tg_channel_id: string
- type: Interest
- description: string

TelegramDialogue Entity:

- id: uiid
- user_id: string
- telegram_entity_id: string
- tg_dialogue_id: string
- description: string

ChannelSummary Entity:

- id: uiid
- tg_channel_entity_id: string
- summary: string
- date: string

Telegram summarizing channels: parse channel theme via llm -> save
`tg_channel_id: theme` to database

Substack summarizing articles: parse article content via llm -> save
`substack_article_id: theme` to database

HN summarizer:

Youtube summarizer: filter out videos without words (music covers etc) -> get
video transcript -> parse video content via llm -> save
`youtube_video_id: theme` to database

twitter summarizer:

reddit summarizer:

### how to parse content theme

throw content to llm and ask it to classify the theme (e.g. "tell be what this
article is about, reply with one word either technology or...")
