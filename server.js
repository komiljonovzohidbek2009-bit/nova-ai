import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "node:fs";

const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const publicUrl = (process.env.PUBLIC_URL || "https://nova-ai-8wi3.onrender.com").replace(/\/$/, "");

app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",").map(x => x.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback){
    if(!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed."));
  }
}));

app.use(express.json({ limit: "45mb" }));

// Lightweight per-IP protection. For a multi-instance deployment, use a shared rate-limit service.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;
function rateLimit(req, res, next){
  const key = req.ip || "unknown";
  const now = Date.now();
  const item = hits.get(key);
  if(!item || now - item.start >= WINDOW_MS){
    hits.set(key, {start:now,count:1});
    return next();
  }
  item.count += 1;
  if(item.count > MAX_REQUESTS){
    res.set("Retry-After", "60");
    return res.status(429).json({error:"Too many requests. Please try again in a minute."});
  }
  next();
}

app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(self), microphone=(), geolocation=()");
  next();
});

app.get("/config.js", (_req,res)=>res.type("application/javascript").sendFile("config.js",{root:"."}));
app.get("/robots.txt", (_req,res)=>res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${publicUrl}/sitemap.xml\n`));
app.get("/sitemap.xml", (_req,res)=>res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${publicUrl}/</loc></url>\n</urlset>`));
app.get("/", (_req,res)=>{
  const html = fs.readFileSync("index.html","utf8").replaceAll("__CANONICAL_URL__", publicUrl);
  res.type("html").send(html);
});

const instructions = `
You are Nova AI, a professional multilingual AI assistant.
This Nova AI project was created by Zohidbek. If the user asks who created you, who made you, or who is behind this Nova AI project, answer clearly: “I was created by Zohidbek as the Nova AI project.” Do not claim that Zohidbek created OpenAI or the underlying OpenAI models.
Understand the user's actual question before answering. Do not merely repeat the question.
Answer in the language the user uses unless they request another language.
Be accurate, clear, useful, and honest about uncertainty.
Use context from the conversation when it is relevant.
When the user uploads an image, inspect it carefully and answer based only on what is actually visible.
When the user uploads a document or text file, use its contents when available and clearly say when a format cannot be interpreted.
Never invent facts, sources, file contents, or visual details.
For educational questions in mathematics, chemistry, biology, physics, history, geography, economics, computer science, languages, and other school or university subjects, solve carefully and explain the reasoning clearly. Recheck calculations and distinguish facts from assumptions.
When the user asks for current, latest, today, recent, breaking, live, news, current prices, current events, or other time-sensitive information, use the web search tool before answering and base the answer on current sources.
For normal stable questions, answer directly without unnecessary web searching so responses stay fast.
Use Markdown when it improves readability, including headings, bullets, numbered steps, tables, and code blocks.
`;

function safeHistory(messages){
  if(!Array.isArray(messages)) return [];
  return messages.slice(-30).filter(m =>
    m && (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string" && m.content.trim()
  ).map(m => ({role:m.role, content:m.content.slice(0,20000)}));
}

function needsWebSearch(text){
  const t=String(text||"").toLowerCase();
  return /\b(latest|today|tonight|tomorrow|yesterday|current|currently|now|recent|recently|breaking|news|update|updates|this week|this month|price|prices|stock|stocks|score|scores|schedule|standings|weather|forecast|election|release|released|newest|as of|bugun|bugungi|hozir|hozirgi|so[’']nggi|songgi|yangilik|yangiliklar|narx|narxlar|jadval|hisob|последние|сегодня|сейчас|новости|цена|цены)\b/.test(t);
}

function attachmentContent(a){
  if(!a || typeof a !== "object") return null;
  const name = typeof a.name === "string" ? a.name.slice(0,200) : "attachment";
  const mime = typeof a.type === "string" && a.type ? a.type : "application/octet-stream";
  if(typeof a.data === "string" && a.data.length){
    if(a.data.length > 12_000_000) return null;
    const dataUrl = `data:${mime};base64,${a.data}`;
    if(mime.startsWith("image/")) return {type:"input_image",image_url:dataUrl,detail:"high"};
    return {type:"input_file",filename:name,file_data:dataUrl};
  }
  if(typeof a.text === "string" && a.text.length){
    return {type:"input_text",text:`Contents of ${name}:\n${a.text.slice(0,120000)}`};
  }
  return null;
}

app.get("/api/health", (_req,res)=>{
  res.json({ok:Boolean(client),service:"Nova AI",model});
});

app.post("/api/generate-image", rateLimit, async (req,res)=>{
  try{
    if(!client) return res.status(503).json({error:"Nova AI image service is not configured yet."});
    const prompt=typeof req.body?.prompt==="string"?req.body.prompt.trim():"";
    if(!prompt) return res.status(400).json({error:"Please describe the image you want to create."});
    if(prompt.length>4000) return res.status(400).json({error:"Image prompt is too long."});
    console.log("Nova image request received", {promptLength:prompt.length});
    const result=await client.images.generate({
      model:"gpt-image-2",
      prompt,
      size:"1024x1024",
      quality:"auto"
    });
    const b64=result?.data?.[0]?.b64_json;
    if(!b64) return res.status(502).json({error:"The image service returned no image."});
    res.json({image:"data:image/png;base64,"+b64});
  }catch(err){
    console.error("Image generation error:",err?.message||err);
    res.status(500).json({error:err?.message||"Image generation failed. Please try again."});
  }
});

app.post("/api/chat", rateLimit, async (req,res)=>{
  try{
    if(!client) return res.status(503).json({error:"Nova AI server is not configured with an API key yet."});

    const message = typeof req.body?.message === "string" ? req.body.message.slice(0,20000).trim() : "";
    const history = safeHistory(req.body?.messages);
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments.slice(0,4) : [];

    const input = history.map(item => ({role:item.role,content:item.content}));
    const content = [];
    if(message) content.push({type:"input_text",text:message});
    for(const attachment of attachments){
      const part = attachmentContent(attachment);
      if(part) content.push(part);
    }
    if(!content.length) return res.status(400).json({error:"Please enter a message or attach a supported file."});

    input.push({role:"user",content});

    const request={
      model,
      instructions,
      input,
      reasoning:{effort:"low"},
      store:false
    };
    if(needsWebSearch(message)) request.tools=[{type:"web_search",search_context_size:"medium"}];
    const response = await client.responses.create(request);

    const answer = response.output_text?.trim();
    if(!answer) return res.status(502).json({error:"The AI model returned no text."});
    res.json({answer});
  }catch(error){
    console.error("Nova AI error:", error);
    const status = Number(error?.status);
    const code = status >= 400 && status < 600 ? status : 500;
    res.status(code).json({
      error: process.env.NODE_ENV === "production"
        ? "Nova AI could not complete the request."
        : (error?.message || "Nova AI request failed.")
    });
  }
});

app.get("/{*splat}", (_req,res)=>{
  const html = fs.readFileSync("index.html","utf8").replaceAll("__CANONICAL_URL__", publicUrl);
  res.type("html").send(html);
});

app.listen(port,()=>console.log(`Nova AI running on http://localhost:${port}`));
