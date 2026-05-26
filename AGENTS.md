1. Do not make too large methods, they should follow a single responsibility principle. If method doing different things make sure to move logic to different methods. Example

BAD:

```js
const processEverything = async () => {
  const messagses = await api.getMessages();

  messages.filter(msg => {...// big logic here a lot of LOC })

  messages.forEach(msg => { fs.writeFileSync(message.attachments); // also lots of LOC });
}
```

GOOD:

```js
const processEverything = async () => {
  let messages = await api.getMessages();
  messages = this.filterMessages();

  this.downloadMessagesMedia(messages);
};
```

2. Avoid short names for common words, like `msg` instead of `message`.
