ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-slim
COPY . /ctx
RUN find /ctx
