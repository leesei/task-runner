- write a task queue and runner system to execute CLI command
- the stdout, stderr of the commands are logged and can be viewed from a dashboard
- the status of the task queues and runner system can be viewed from a dashboard
- user add task with context to the system, tasks are extensible
- user can specify a task folder to add to the look up
- the task is looked up from the default and user task folders by id, like $PATH
- each task should have README and settings
- each registered task correspond to a task queue and can create task instance
- the default function of the task will be executed as an task instance
- each task's concurrency (number of task instance in RUNNING state) can be configured
- write using Bun, use as much Bun built-in as possible
- A Task has the following states:
  - PENDING
  - RUNNING
  - SUCCESS
  - FAILED
- user can issue start/stop/abort processing per task queue
  start: start to process PENDING tasks
  stop: do complete any current RUNNING tasks, do not process next PENDING task
  abort: kill the current RUNNING task and set it to PENDING, do not process next PENDING task
- The task queue hence has the following states:
  - IDLE
  - PROCESSING
  - STOPPED
- sample commands (ls and minfo are task queue id)

  ```sh
  # start the service
  # registered tasks should autostart
  tq daemon

  tq add ls fixture/1
  tq add ls fixture/2
  tq add minfo fixture/1
  tq add minfo fixture/2

  tq stop ls
  tq start ls
  tq abort minfo

  tq clear ls # clear SUCCESS tasks
  tq clear --all ls # clear all tasks
  ```

the design is not final, please assist me with it
You may suggest better way to improve my design
I don't have the following thought through

- how to specify the input format (the context) of a task? should the task defines a convention?
- how should a plugin expose multiple task?
- how should multiple tasks share common module

I would like you to write a specification with this prompt as input
and log issues we would further discuss and clarify

---

Round 1

1. I suppose you mean the daemon is single process, which forks task instances to run the command line in the background.
2. I think adding namespace is good, adopt it now; folder as task, package with multiple folder is good. Can you check agent skills structure to see if we can learn from it ?
3. I think you get the point, feel free to modify the current code if needed, they are just sample use cases.
4. I originally mean multiple tasks in a package sharing code. this is solved once you we have a design for package with multiple skills.
5. a. each task have a skill, the system won't do scheduling, the task's execution can implement
   scheduling; b. each task has its own setting and concurrent RUNNING task number;
6. a. daemon start to process, no need to change system setting to make the daemon autostart; b. to sqlite db via Bun's API
7. a. yes, web UI; b. the daemon serves it, needs realtime update
8. your understanding is correct
9. your understanding is correct

---

Round 2

your understanding is correct, please proceed
