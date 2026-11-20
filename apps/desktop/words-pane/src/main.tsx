import { StrictMode, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChatMarkdown } from "./ChatMarkdown"

type Msg = {
  role: "user" | "agent"
  text: string
  fresh?: boolean
  muted?: boolean
  divider?: string
}

type Payload = {
  dark?: boolean
  reduceMotion?: boolean
  chatMaxPx?: number
  messages?: Msg[]
  pendingAnswer?: string | null
  loading?: string | null
}

function Thread({ data }: { data: Payload }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: data.reduceMotion ? "auto" : "smooth" })
  }, [data.messages?.length, data.pendingAnswer, data.reduceMotion])

  useEffect(() => {
    document.documentElement.classList.toggle("dark", data.dark === true)
    if (data.chatMaxPx) {
      document.documentElement.style.setProperty("--chat-max", `${data.chatMaxPx}px`)
    }
  }, [data.dark, data.chatMaxPx])

  return (
    <div className="thread">
      {data.loading ? <p className="loading">{data.loading}</p> : null}
      {data.messages?.map((m, i) =>
        m.divider ? (
          <div key={i} className="divider">
            <span>{m.divider}</span>
          </div>
        ) : m.role === "user" ? (
          <p key={i} className="user">
            {m.text}
          </p>
        ) : (
          <div key={i} className={`agent${m.muted ? " muted" : ""}`}>
            <ChatMarkdown text={m.text} reveal={m.fresh} />
          </div>
        ),
      )}
      {data.pendingAnswer ? (
        <div className="agent live">
          <ChatMarkdown text={data.pendingAnswer} live reveal />
        </div>
      ) : null}
      <div ref={end} />
    </div>
  )
}

function App() {
  const [data, setData] = useState<Payload>({})
  useEffect(() => {
    window.__openrecord = (next: Payload) => setData(next ?? {})
  }, [])
  return <Thread data={data} />
}

declare global {
  interface Window {
    __openrecord?: (payload: Payload) => void
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)