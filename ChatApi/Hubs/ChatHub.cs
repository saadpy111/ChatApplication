using System;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace ChatApi.Hubs;
[Authorize]
public class ChatHub:Hub
{
        public async Task SendMessage(string userid, string message)
        {
            await Clients.User(userid).SendAsync("ReceiveMessage",message);
        }
}
