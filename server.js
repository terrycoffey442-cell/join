const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LEADER_TIMEOUT_MS = 60000; // 60s không ping -> phế truất Leader cũ

// Bộ nhớ lưu trữ trạng thái các phòng
const rooms = {};

function getOrCreateRoom(leagueId) {
    if (!rooms[leagueId]) {
        rooms[leagueId] = {
            leagueId,
            leagueName: "Unknown",
            clanRank: null,
            totalRanked: null,
            clanPoints: 0,
            contributions: [],
            status: "IDLE", // IDLE | SCOUTING | READY | FARMING
            jobId: null,
            leader: null,
            lastHeartbeat: 0,
            members: {},
            blockedJobIds: {}
        };
    }
    return rooms[leagueId];
}

// 1. Xem trạng thái Dashboard toàn bộ phòng trực tiếp trên trình duyệt Web (JSON)
app.get("/", (req, res) => {
    const now = Date.now();
    const formattedRooms = {};

    for (const [leagueId, room] of Object.entries(rooms)) {
        const formattedMembers = {};
        let inTargetCount = 0;

        for (const [name, m] of Object.entries(room.members)) {
            const inTarget = (m.jobId === room.jobId);
            if (inTarget) inTargetCount++;
            formattedMembers[name] = {
                role: (name === room.leader) ? "SCOUT" : "WORKER",
                inTargetServer: inTarget,
                lastPingAgo: Math.round((now - m.ping) / 1000)
            };
        }

        formattedRooms[leagueId] = {
            leagueName: room.leagueName,
            clanRank: room.clanRank,
            totalRanked: room.totalRanked,
            clanPoints: room.clanPoints,
            status: room.status,
            targetJobId: room.jobId,
            leader: room.leader,
            lastUpdatedSecondsAgo: Math.round((now - room.lastHeartbeat) / 1000),
            memberCount: Object.keys(room.members).length,
            membersInTargetServer: inTargetCount,
            members: formattedMembers,
            contributions: room.contributions
        };
    }

    res.json({
        serverStatus: "ONLINE",
        activeRoomsCount: Object.keys(rooms).length,
        rooms: formattedRooms
    });
});

// 2. Handshake: Xác định vai trò (Scout / Worker) & Cập nhật Rank + Points
app.post("/api/league/handshake", (req, res) => {
    const { leagueId, leagueName, username, currentJobId, clanRank, totalRanked, clanPoints, contributions } = req.body;
    if (!leagueId || !username) return res.status(400).json({ error: "Missing leagueId or username" });

    const room = getOrCreateRoom(leagueId);
    const now = Date.now();

    // Cập nhật thông tin clan nếu có
    if (leagueName) room.leagueName = leagueName;
    if (clanRank !== undefined && clanRank !== null) room.clanRank = clanRank;
    if (totalRanked !== undefined && totalRanked !== null) room.totalRanked = totalRanked;
    if (clanPoints !== undefined && clanPoints !== null) room.clanPoints = clanPoints;
    if (contributions) room.contributions = contributions;

    room.members[username] = { ping: now, jobId: currentJobId };

    // Dọn dẹp các server bị block quá 10 phút
    for (const [jid, time] of Object.entries(room.blockedJobIds)) {
        if (now - time > 600000) delete room.blockedJobIds[jid];
    }

    const leaderDead = !room.leader || (now - room.lastHeartbeat > LEADER_TIMEOUT_MS);

    if (leaderDead) {
        room.leader = username;
        room.lastHeartbeat = now;
        room.status = "SCOUTING";
        return res.json({
            role: "SCOUT",
            status: room.status,
            targetJobId: room.jobId,
            blockedJobIds: Object.keys(room.blockedJobIds)
        });
    }

    if (room.leader === username) {
        room.lastHeartbeat = now;
        return res.json({
            role: "SCOUT",
            status: room.status,
            targetJobId: room.jobId,
            blockedJobIds: Object.keys(room.blockedJobIds)
        });
    }

    return res.json({
        role: "WORKER",
        status: room.status,
        targetJobId: (room.status === "READY" || room.status === "FARMING") ? room.jobId : null,
        blockedJobIds: Object.keys(room.blockedJobIds)
    });
});

// 3. Leader chốt server đạt chuẩn (<= 6 người)
app.post("/api/league/ready", (req, res) => {
    const { leagueId, username, jobId, playerCount, clanRank, totalRanked, clanPoints } = req.body;
    const room = getOrCreateRoom(leagueId);

    if (room.leader !== username) {
        return res.status(403).json({ error: "Only leader can set room ready" });
    }

    if (playerCount > 6) {
        room.status = "SCOUTING";
        return res.status(400).json({ error: "Player count exceeds 6" });
    }

    room.status = "READY";
    room.jobId = jobId;
    room.lastHeartbeat = Date.now();
    if (clanRank !== undefined && clanRank !== null) room.clanRank = clanRank;
    if (totalRanked !== undefined && totalRanked !== null) room.totalRanked = totalRanked;
    if (clanPoints !== undefined && clanPoints !== null) room.clanPoints = clanPoints;

    console.log(`[LEAGUE] Room ${leagueId} READY! Server: ${jobId} (${playerCount} players)`);
    res.json({ success: true, status: room.status, jobId: room.jobId });
});

// 4. Heartbeat định kỳ (Mỗi 15s) cập nhật Rank, Points, và trạng thái online
app.post("/api/league/heartbeat", (req, res) => {
    const { leagueId, leagueName, username, currentJobId, clanRank, totalRanked, clanPoints, contributions } = req.body;
    const room = getOrCreateRoom(leagueId);
    const now = Date.now();

    if (leagueName) room.leagueName = leagueName;
    if (clanRank !== undefined && clanRank !== null) room.clanRank = clanRank;
    if (totalRanked !== undefined && totalRanked !== null) room.totalRanked = totalRanked;
    if (clanPoints !== undefined && clanPoints !== null) room.clanPoints = clanPoints;
    if (contributions) room.contributions = contributions;

    if (room.members[username]) {
        room.members[username].ping = now;
        room.members[username].jobId = currentJobId;
    }
    if (room.leader === username) {
        room.lastHeartbeat = now;
    }

    const shouldMigrate = Boolean(room.status === "READY" && room.jobId && currentJobId && currentJobId !== room.jobId);

    res.json({
        status: room.status,
        targetJobId: room.jobId,
        leader: room.leader,
        command: shouldMigrate ? "MIGRATE" : "STAY",
        newTargetJobId: shouldMigrate ? room.jobId : null
    });
});

// 5. Yêu cầu đổi server mới khi có sự cố
app.post("/api/league/request-hop", (req, res) => {
    const { leagueId, username } = req.body;
    const room = getOrCreateRoom(leagueId);

    room.status = "SCOUTING";
    room.jobId = null;
    room.leader = username;
    room.lastHeartbeat = Date.now();

    console.log(`[LEAGUE] Room ${leagueId} requested hop by ${username}`);
    res.json({ success: true, role: "SCOUT" });
});

// 6. Báo server bị đầy (acc crash không vào lại được -> Kích hoạt dời server cho cả cụm)
app.post("/api/league/report-server-full", (req, res) => {
    const { leagueId, username, fullJobId } = req.body;
    const room = getOrCreateRoom(leagueId);

    if (fullJobId) {
        room.blockedJobIds[fullJobId] = Date.now();
    }

    if (!room.jobId || room.jobId === fullJobId) {
        room.status = "SCOUTING";
        room.jobId = null;
        room.leader = username;
        room.lastHeartbeat = Date.now();
        console.log(`[LEAGUE] Room ${leagueId} server ${fullJobId} reported FULL by ${username}. Switched to SCOUTING.`);
    }

    res.json({
        success: true,
        status: room.status,
        role: (room.leader === username ? "SCOUT" : "WORKER"),
        blockedJobIds: Object.keys(room.blockedJobIds)
    });
});

app.listen(PORT, () => {
    console.log(`Coordinator server running on port ${PORT}`);
});
