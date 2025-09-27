import { Link } from "react-router-dom";
import { MediaPlayer, MediaProvider } from "@vidstack/react";
import { defaultLayoutIcons, DefaultVideoLayout } from "@vidstack/react/player/layouts/default";
import { useEffect, useState } from "react";
import Chat, { type User } from "./Chat";

const getOauthGoogleUrl = () => {
    const { VITE_GOOGLE_CLIENT_ID, VITE_GOOGLE_AUTHORIZED_REDIRECT_URI } = import.meta.env;
    const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const options = {
        redirect_uri: VITE_GOOGLE_AUTHORIZED_REDIRECT_URI,
        client_id: VITE_GOOGLE_CLIENT_ID,
        access_type: "offline",
        response_type: "code",
        prompt: "consent",
        scope: [
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/userinfo.email",
        ].join(" "),
    };
    const qs = new URLSearchParams(options);
    return `${rootUrl}?${qs.toString()}`;
};

function Home() {
    const [user, setUser] = useState<User | null>(null);
    const isAuthenticated = Boolean(localStorage.getItem("access_token"));
    const oauthURL = getOauthGoogleUrl();
    const logout = () => {
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        window.location.reload();
    };
    useEffect(() => {
        if (!isAuthenticated) return;
        const fetchUserData = async () => {
            const response = await fetch("http://localhost:3000/api/users/me", {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${localStorage.getItem("access_token")}`,
                },
            });
            const data = await response.json();
            const user = data.data || {};
            setUser(user);
        };
        fetchUserData();
    }, [isAuthenticated]);
    return (
        <div className=" flex flex-col justify-center  p-4">
            <Chat user={user} />
            <div>
                <h2>HLS Streaming</h2>
                <MediaPlayer
                    title="Sprite Fight"
                    src="http://localhost:3000/api/static/video-hls/jMfRtmXNuQGiuQ-O4XBSF/master.m3u8"
                >
                    <MediaProvider />
                    <DefaultVideoLayout
                        thumbnails="https://files.vidstack.io/sprite-fight/thumbnails.vtt"
                        icons={defaultLayoutIcons}
                    />
                </MediaPlayer>
            </div>

            <h1>OAuth Google</h1>
            <div>
                {isAuthenticated ? (
                    <div>
                        <p>Xin chào, bạn đã login thành công</p>
                        <button onClick={logout}>Click để logout</button>
                    </div>
                ) : (
                    <Link to={oauthURL}>Login with Google</Link>
                )}
            </div>
        </div>
    );
}

export default Home;
