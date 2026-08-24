# OrangeSable
OrangeSable is a fast, multi-threaded voxel engine for JavaScript.  
Written with raw WebGL for maximum performance, it is designed to be used as a game engine for any of your wildest ideas.

## Server-client architecture
OrangeSable uses a `IsomorphicWebsocket` system to support singleplayer, meaning that all 'Singleplayer' is actually *Multiplayer* in disguise.  
This also means that the client is a blank canvas and relies entirely on the server for: block definitions, logic, movement, etc.

### AI Disclaimer
*Some* AI was used for the creation of this game, mainly the GUI since I (SpinningCubes) am horrible at UX design 😭.