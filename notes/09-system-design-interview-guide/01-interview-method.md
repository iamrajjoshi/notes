---
title: How to Approach a System Design Interview
description: Working notes on navigating a system design interview.
slug: interview-method
order: 1
---

## Summary

A practical framework for navigating a system design interview: clarify and prioritize requirements, communicate tradeoffs, build a simple high-level design, and deepen it iteratively.

## Why does the interview exist?

Contrary to Leetcode/Practical/AI interviews, System design interviews is primarly a signal on understanding how well you know broadly the technologies that make up tech today and how you can take an ambigous problem, refine requirements, and break it down into manageable chunks. It is perhaps the closest interview to your real life job. *

(asterisk here since this is actually only true for ifnra/platform engineers since product engineers generally don't have to deal with this.)

### System design interview rubric

Before we dive into how you should approach an interview, its important to lay down what interviews are even gathering signal for:

Broadly, it comes down to 4 main parts:

1. How well you navigate the problem
2. How well do you know your foundational technologies and you can utilize them to design a solution
3. How well can you design a solution
4. How well you can communicate your ideas

#### Problem navigation

System design interview questions are very ambigous and under specifies so its up to the interviewer to actually guide the discussion, prioritizing important parts of the design and skimming over the insignificant chunks.

This means its important to

- gather requirements
- prioritze, priortize, prioritize
- create a simple working solution, iterate as you go own

#### Foundational Technolgies

Interviewers want to your command on the technologies you are utilizing to solve eahc part of the problem. this mainly means you need to have an understanding of various core technoglies to help build a working solution. Whats also important here is to keep designs simple and building a well structured design, not "spagetti code" equivalent

Knowing modern tecnologies and patterns is instrumental to passing these interviews.

#### Communication

In real life, when designing systems, communication is really important. In a real job, you're going to be talking to a bunch of stakeholders, other engineers on your team. Being able to effectively communicate your ideas is instrumental in the design's success. Being able to understand, listen to your interviewer, figure out what parts they are prodding for and what additional information they want, and being collaborative with the interviewer is extremely important.

## Delivery Framework

Now the meat of it - How should you actually conduct an interview:

Having a mental outline when going through a system design interview is paramount to make sure that you are able to actually deliver a working system. Time management is difficult for candidates who are new at these types of interviews so having something internalized makes it easy to stay on track.

### Structure

1. Gather requirements
2. Define core entities
3. Define API or interface
4. (Optional) Define high level data flow
5. High-level design
6. Deep dives

(Loop from HLD to requirements and Deep dives to requirements)

1. Requirements (~5 minutes)

The goal here is to understand what you are supposed to be building. What are the requirements? To do so, the best way is to split your requirements into 2 buckets:

1. Functional requirements

This is your "The user should be able to ..." statements. They define the core functionality your system provides and is important to nail down.

A trick for this is to ask questions to your interviewer as if they are a customer and you are on a customer research call. Things like "Should the system do X", "What happens if Y occurs" are all good conversation starters.

Callout:
Make sure to keep you requirements super specific and with intention. For the rest of the interview, you will be addressing these requirements that you have built up so you need to be strategic in how you prioritize. Designing something like Twitter, Facebook, Web Crawler have hundreds if not thousands of features, but you must pick the most important ones (say 3) and focus on them. Adding more will only make rest of the interview more difficult (and perhaps a red flag for interviewers for your ability to narrow down requirements).

2. Non-functional Requirements

This represents the behavior of your system that will be important to the user. Think "The system should...."

Here its important to keep the context of the system in mind and try to be quantifiable. Saying something like "the system should be low latency" isn't ideal since most people would want their system to be low latency and you can't really measure it. Something better would be "The system should have low latency search < 100 ms" since this would help you later on in your interview improve the search system and provide a goal.

Coming up with non functional requirements is easier said than done (especially if you haven't built the system in real life before), but some key ideas to incorporate are:

1. CAP theorem (pick between consistency and avaibility since fault tolerence is implied in a distributed systen)
2. Envirornment constraints: is the system suppose to run on resource constraint machines? phones, etc.
3. Scalability: x

## References

This guide is based on personal interview-preparation notes; external references have not been added yet.
