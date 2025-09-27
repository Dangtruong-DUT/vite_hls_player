import { useCallback, useEffect, useRef, useState } from "react";
import InfiniteScroll from "react-infinite-scroll-component";
import { io, Socket } from "socket.io-client";

export type User = {
    avatar: string;
    bio: string;
    cover_photo: string;
    created_at: string;
    date_of_birth: string;
    email: string;
    followers_count: number;
    following_count: number;
    is_followed: boolean;
    location: string;
    name: string;
    updated_at: string;
    username: string;
    verify: number;
    website: string;
    _id: string;
};

const list_user_id = ["688452006299004e34976028", "687dfe7e5db6fa0f4b96a5df"];

export type Message = {
    content: string;
    receiver_id: string;
    sender_id: string;
    created_at: string;
};

export type pagination = {
    page: number;
    limit: number;
    total_pages: number;
};

export default function Chat({ user }: { user: User | null }) {
    const socketReference = useRef<Socket | null>(null);
    const [message, setMessage] = useState("");
    const [messages, setMessages] = useState<Message[]>([]);
    const [totalPage, setTotalPage] = useState(1);
    const pageRef = useRef(0);
    const token = localStorage.getItem("access_token");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!message.trim() || !user) return;
        const body: Message = {
            content: message,
            receiver_id: user._id === list_user_id[0] ? list_user_id[1] : list_user_id[0],
            sender_id: user._id,
            created_at: new Date().toISOString(),
        };
        socketReference.current?.emit("private_message", body);
        setMessages((prevMessages) => [body, ...prevMessages]);
        setMessage("");
    };

    useEffect(() => {
        if (!user || socketReference.current) return;

        socketReference.current = io("http://localhost:3000", {
            auth: {
                Authorization: `Bearer ${token}`,
            },
        });

        socketReference.current.on("connect", () => {
            console.log("Connected to chat server");
        });

        socketReference.current.on("disconnect", () => {
            console.log("Disconnected from chat server");
        });

        socketReference.current.on("connect_error", (err) => {
            console.error("Connection error:", err);
        });

        socketReference.current.on("private_message", (data: Message) => {
            setMessages((prevMessages) => [data, ...prevMessages]);
        });

        return () => {
            if (socketReference.current) {
                socketReference.current.disconnect();
                socketReference.current = null;
                console.log("Disconnected from chat server");
            }
        };
    }, [user]);

    const fetchMoreData = useCallback(async () => {
        if (!user) return;

        const receiver_id = user._id === list_user_id[0] ? list_user_id[1] : list_user_id[0];
        const nextPage = pageRef.current + 1;

        const response = await fetch(
            `http://localhost:3000/api/conversations/receivers/${receiver_id}?page=${nextPage}&limit=10`,
            {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const data: { meta: pagination; data: Message[] } = await response.json();
        setMessages((prevMessages) => [...prevMessages, ...data.data]);
        pageRef.current = data.meta.page;
        setTotalPage(data.meta.total_pages);
    }, [user]);

    useEffect(() => {
        if (user?._id && pageRef.current === 0) {
            fetchMoreData();
        }
    }, [user, fetchMoreData]);

    return (
        <div className="px-4 py-2 flex flex-col items-center mb-7">
            <h1>Chat</h1>
            {user && <p>Welcome, {user.email}!</p>}
            <div className="w-full max-w-md border rounded p-4 mb-4">
                <h2 className="text-lg font-semibold mb-2">Messages</h2>
                <div className="flex flex-col max-h-60 overflow-y-auto">
                    <div
                        id="scrollableDiv"
                        style={{
                            height: 200,
                            overflow: "auto",
                            display: "flex",
                            flexDirection: "column-reverse",
                        }}
                    >
                        <InfiniteScroll
                            dataLength={messages.length}
                            next={fetchMoreData}
                            style={{ display: "flex", flexDirection: "column-reverse" }}
                            inverse={true}
                            hasMore={pageRef.current < totalPage}
                            loader={<h4>Loading...</h4>}
                            scrollableTarget="scrollableDiv"
                        >
                            {messages.map((message) => (
                                <div
                                    key={message.created_at}
                                    className={message.sender_id === user?._id ? "text-right rou" : "text-left"}
                                >
                                    {message.content} - {new Date(message.created_at).toLocaleTimeString()}{" "}
                                    {message.sender_id === user?._id ? "(You)" : "(Them)"}
                                </div>
                            ))}
                        </InfiniteScroll>
                    </div>
                </div>
                <form method="post" className="flex gap-2 mt-2" onSubmit={handleSubmit}>
                    <input
                        type="text"
                        placeholder="Type your message..."
                        className="border p-2 rounded w-full"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                    />
                    <button type="submit" className="text-white p-2 rounded bg-blue-500">
                        Send
                    </button>
                </form>
            </div>
        </div>
    );
}
