export default function FormatTime(props: { ms: number }) {
  const text = () => new Date(props.ms).toLocaleString();
  return <time dateTime={new Date(props.ms).toISOString()}>{text()}</time>;
}
