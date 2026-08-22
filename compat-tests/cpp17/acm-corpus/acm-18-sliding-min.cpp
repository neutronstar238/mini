#include <bits/stdc++.h>
using namespace std;
int main(){vector<int>a{3,1,2,0,4};deque<int>q;for(int i=0;i<5;i++){while(!q.empty()&&a[q.back()]>=a[i])q.pop_back();q.push_back(i);if(q.front()<=i-2)q.pop_front();if(i>=2)cout<<a[q.front()]<<' ';}cout<<"\n";}
